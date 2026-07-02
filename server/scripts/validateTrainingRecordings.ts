/**
 * validateTrainingRecordings.ts
 *
 * Offline validation tool for AI training JSONL recording files.
 *
 * Usage:
 *   npx tsx scripts/validateTrainingRecordings.ts [path/to/dir-or-file.jsonl]
 *   npm run validate:training-recordings [-- path]
 *
 * Without a path argument, reads from stdin (piped JSONL).
 *
 * Exit codes:
 *   0 — all records valid (or 0 records found)
 *   1 — one or more records failed validation
 *   2 — file/directory read error
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, extname } from 'node:path'
import { validateTrainingRecord } from '../src/trainingRecorder/trainingRecorderIntegrity.js'
import type { TrainingDealRecord } from '../src/trainingRecorder/trainingRecorderTypes.js'

// ─── Config ───────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1

// ─── Stats ────────────────────────────────────────────────────────────────────

type Stats = {
  filesScanned: number
  linesRead: number
  blankLines: number
  parseErrors: number
  schemaErrors: number
  incomplete: number
  valid: number
  invalid: number
  totalInitialCards: number
  totalPlayedCards: number
  actorKindCounts: Record<string, number>
  contractTypeCounts: Record<string, number>
}

function createStats(): Stats {
  return {
    filesScanned: 0,
    linesRead: 0,
    blankLines: 0,
    parseErrors: 0,
    schemaErrors: 0,
    incomplete: 0,
    valid: 0,
    invalid: 0,
    totalInitialCards: 0,
    totalPlayedCards: 0,
    actorKindCounts: {},
    contractTypeCounts: {},
  }
}

// ─── Record validation ────────────────────────────────────────────────────────

function validateSchemaVersion(obj: unknown): string | null {
  if (typeof obj !== 'object' || obj === null) return 'not an object'
  const r = obj as Record<string, unknown>
  if (r['schemaVersion'] !== SCHEMA_VERSION) return `schemaVersion must be ${SCHEMA_VERSION}, got ${r['schemaVersion']}`
  if (typeof r['recordingId'] !== 'string' || !r['recordingId']) return 'missing recordingId'
  if (typeof r['completed'] !== 'boolean') return 'missing completed flag'
  if (typeof r['roomKey'] !== 'string') return 'missing roomKey'
  if (typeof r['dealIndex'] !== 'number') return 'missing dealIndex'
  return null
}

function processLine(
  line: string,
  lineNum: number,
  filePath: string,
  stats: Stats,
  verbose: boolean,
): void {
  stats.linesRead++

  const trimmed = line.trim()
  if (!trimmed) { stats.blankLines++; return }

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch (e) {
    stats.parseErrors++
    console.error(`[PARSE ERROR] ${filePath}:${lineNum}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }

  const schemaErr = validateSchemaVersion(obj)
  if (schemaErr) {
    stats.schemaErrors++
    console.error(`[SCHEMA ERROR] ${filePath}:${lineNum}: ${schemaErr}`)
    return
  }

  const record = obj as { completed: boolean } & Record<string, unknown>

  // Incomplete records are informational only
  if (!record['completed']) {
    stats.incomplete++
    if (verbose) {
      console.log(`  [INCOMPLETE] ${filePath}:${lineNum}: ${record['recordingId']} — ${record['terminationReason'] ?? 'unknown reason'}`)
    }
    return
  }

  // Full deal record
  const dealRecord = record as unknown as TrainingDealRecord
  const integrity = validateTrainingRecord(dealRecord, trimmed)

  if (integrity.valid) {
    stats.valid++
    stats.totalInitialCards += integrity.initialCardCount
    stats.totalPlayedCards += integrity.playedCardCount

    // Tally actor kinds
    for (const action of dealRecord.biddingActions ?? []) {
      const k = action.actorKind ?? 'unknown'
      stats.actorKindCounts[k] = (stats.actorKindCounts[k] ?? 0) + 1
    }
    for (const action of dealRecord.cardActions ?? []) {
      const k = action.actorKind ?? 'unknown'
      stats.actorKindCounts[k] = (stats.actorKindCounts[k] ?? 0) + 1
    }

    // Tally contract types
    const ct = dealRecord.finalContract?.contract ?? 'unknown'
    stats.contractTypeCounts[ct] = (stats.contractTypeCounts[ct] ?? 0) + 1

    if (verbose) {
      const rk = (dealRecord as any).recordKind ?? 'full'
      console.log(`  [VALID]   ${filePath}:${lineNum}: ${dealRecord.recordingId} — ${rk} — ${dealRecord.cardActions.length} plays, contract=${ct}`)
    }
  } else {
    stats.invalid++
    console.error(`  [INVALID] ${filePath}:${lineNum}: ${dealRecord.recordingId}`)
    for (const v of integrity.violations) {
      console.error(`            • ${v}`)
    }
  }
}

// ─── Stream processor ─────────────────────────────────────────────────────────

async function processStream(
  stream: NodeJS.ReadableStream,
  filePath: string,
  stats: Stats,
  verbose: boolean,
): Promise<void> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNum = 0
  for await (const line of rl) {
    lineNum++
    processLine(line, lineNum, filePath, stats, verbose)
  }
}

async function processFile(filePath: string, stats: Stats, verbose: boolean): Promise<void> {
  stats.filesScanned++
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  await processStream(stream, filePath, stats, verbose)
}

async function processDirectory(dirPath: string, stats: Stats, verbose: boolean): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await processDirectory(full, stats, verbose)
    } else if (entry.isFile() && extname(entry.name) === '.jsonl') {
      await processFile(full, stats, verbose)
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(stats: Stats): void {
  console.log('\n─────────────────────────────────────────')
  console.log('  Training Recordings Validation Report')
  console.log('─────────────────────────────────────────')
  console.log(`  Files scanned:      ${stats.filesScanned}`)
  console.log(`  Lines read:         ${stats.linesRead}`)
  console.log(`  Blank lines:        ${stats.blankLines}`)
  console.log(`  Parse errors:       ${stats.parseErrors}`)
  console.log(`  Schema errors:      ${stats.schemaErrors}`)
  console.log(`  Incomplete deals:   ${stats.incomplete}`)
  console.log(`  Valid records:      ${stats.valid}`)
  console.log(`  Invalid records:    ${stats.invalid}`)

  if (stats.valid > 0) {
    console.log(`\n  Avg initial cards:  ${(stats.totalInitialCards / stats.valid).toFixed(1)}`)
    console.log(`  Avg played cards:   ${(stats.totalPlayedCards / stats.valid).toFixed(1)}`)

    if (Object.keys(stats.actorKindCounts).length > 0) {
      console.log('\n  Actor kind distribution (bid + card actions):')
      const total = Object.values(stats.actorKindCounts).reduce((s, v) => s + v, 0)
      for (const [k, v] of Object.entries(stats.actorKindCounts).sort((a, b) => b[1] - a[1])) {
        const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0'
        console.log(`    ${k.padEnd(20)} ${String(v).padStart(6)}  (${pct}%)`)
      }
    }

    if (Object.keys(stats.contractTypeCounts).length > 0) {
      console.log('\n  Contract type distribution:')
      const total = Object.values(stats.contractTypeCounts).reduce((s, v) => s + v, 0)
      for (const [k, v] of Object.entries(stats.contractTypeCounts).sort((a, b) => b[1] - a[1])) {
        const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0'
        console.log(`    ${k.padEnd(20)} ${String(v).padStart(6)}  (${pct}%)`)
      }
    }
  }

  const hasErrors = stats.parseErrors + stats.schemaErrors + stats.invalid > 0
  console.log(`\n  Result: ${hasErrors ? 'FAIL ✗' : 'PASS ✓'}`)
  console.log('─────────────────────────────────────────\n')
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const verbose = args.includes('--verbose') || args.includes('-v')
  const targetArg = args.find((a) => !a.startsWith('-'))

  const stats = createStats()

  if (!targetArg) {
    // Read from stdin
    console.log('Reading JSONL from stdin…')
    await processStream(process.stdin, '<stdin>', stats, verbose)
  } else {
    try {
      const info = await stat(targetArg)
      if (info.isDirectory()) {
        console.log(`Scanning directory: ${targetArg}`)
        await processDirectory(targetArg, stats, verbose)
      } else if (info.isFile()) {
        console.log(`Validating file: ${targetArg}`)
        await processFile(targetArg, stats, verbose)
      } else {
        console.error(`Not a file or directory: ${targetArg}`)
        process.exit(2)
      }
    } catch (e) {
      console.error(`Cannot access path "${targetArg}": ${e instanceof Error ? e.message : String(e)}`)
      process.exit(2)
    }
  }

  printReport(stats)

  const hasErrors = stats.parseErrors + stats.schemaErrors + stats.invalid > 0
  process.exit(hasErrors ? 1 : 0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
