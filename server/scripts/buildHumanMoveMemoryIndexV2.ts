/**
 * buildHumanMoveMemoryIndexV2.ts
 *
 * Строи memory-aware v2 версия на "human move memory" retrieval index-а
 * (виж buildHumanMoveMemoryIndex.ts за v1 — ОСТАВА непроменен, тази версия
 * е успоредна, не заместваща). Разлика спрямо v1: ContextVector-ът и
 * abstract strategy signature-ът вече включват memory-aware features
 * (playedCardsSoFar/remainingCardsBySuit/remainingTrumpCount/clean-winner/
 * void-suit/currently-winning контекст) — виж humanMoveMemoryV2Shared.ts.
 *
 * ТОВА НЕ Е runtime интеграция. Чисто offline: строи index от train split-а
 * (само non-forced `human_manual` card decisions), записва в
 * training-output/human-move-memory-v2/. Evaluation/comparison/hybrid
 * feasibility анализ е в analyzeHumanMoveMemoryV2.ts (отделен script).
 *
 * Не пипа gameplay, matchmaking, economy, client protocol, recorder writer
 * или production bot behavior.
 *
 * Usage:
 *   npm run build:human-move-memory-index-v2   (от server/)
 *
 * Exit codes:
 *   0 — успешно построен index
 *   1 — invalid/missing input, privacy нарушение, schema грешка
 *   2 — file system грешка (напр. липсващи baseline split файлове)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseJsonlStrict,
  validateCardRecordV2,
  scanAllForbiddenContent,
  buildTrainIndexEntryV2,
  CONTEXT_FEATURE_NAMES_V2,
  SIGNATURE_DEFINITION_V2,
  type CardRecordV2,
  type TrainIndexEntryV2,
} from './humanMoveMemoryV2Shared.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MEMORY_V2_DIR = join(OUTPUT_DIR, 'human-move-memory-v2')

const CARD_TRAIN_PATH = join(BASELINE_DIR, 'card-train.jsonl')
const INDEX_V2_JSON_PATH = join(MEMORY_V2_DIR, 'card-memory-index-v2.json')

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Human Move Memory Index v2 — memory-aware builder (локален, read-only)')
  console.log('─────────────────────────────────────────')

  let trainContent: string
  try {
    trainContent = await readFile(CARD_TRAIN_PATH, 'utf8')
  } catch {
    console.error(`FATAL: липсва необходимия файл: ${CARD_TRAIN_PATH}`)
    console.error('Изпълни първо: npm run prepare:training-baseline')
    process.exit(2)
    return
  }

  console.log('Валидирам card-train.jsonl (включително memory enrichment полета)...')
  const parsedTrain = parseJsonlStrict<Partial<CardRecordV2>>(trainContent, 'card-train.jsonl')
  const schemaErrors: string[] = [...parsedTrain.errors]
  for (const { record, lineNumber } of parsedTrain.lines) {
    schemaErrors.push(...validateCardRecordV2(record, `card-train.jsonl:${lineNumber}`))
  }

  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — build СПРЯН (schema ambiguity).\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  console.log('Privacy/sanitization сканиране на входа...')
  const inputViolations = await scanAllForbiddenContent(CARD_TRAIN_PATH)
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — build СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const trainRecords = parsedTrain.lines.map((l) => l.record as CardRecordV2)

  console.log('Строя memory-aware human move memory index v2 от train split-а (non-forced decisions)...')
  const trainNonForced = trainRecords.filter((r) => r.legalCards.length > 1)
  const trainForcedCount = trainRecords.length - trainNonForced.length

  const buckets = new Map<string, TrainIndexEntryV2[]>()
  for (const r of trainNonForced) {
    const entry = buildTrainIndexEntryV2(r)
    if (!buckets.has(entry.bucketKey)) buckets.set(entry.bucketKey, [])
    buckets.get(entry.bucketKey)!.push(entry)
  }
  const bucketCounts: Record<string, number> = {}
  for (const [key, entries] of buckets) bucketCounts[key] = entries.length

  const indexJson = {
    generatedAt: new Date().toISOString(),
    sourceFile: CARD_TRAIN_PATH,
    indexVersion: 'v2-memory-aware',
    hardBucketDimensions: ['gameMode', 'isLead'],
    contextFeatures: CONTEXT_FEATURE_NAMES_V2,
    signatureDefinition: SIGNATURE_DEFINITION_V2,
    entryCount: trainNonForced.length,
    forcedExcludedCount: trainForcedCount,
    bucketCounts,
    entries: [...buckets.values()].flat(),
  }

  await mkdir(MEMORY_V2_DIR, { recursive: true })
  await writeFile(INDEX_V2_JSON_PATH, JSON.stringify(indexJson, null, 2) + '\n', 'utf8')
  console.log(`Index v2 построен: ${indexJson.entryCount} entries в ${buckets.size} bucket-а (${trainForcedCount} forced изключени).`)

  console.log('Privacy/sanitization сканиране на generated index...')
  const outputViolations = await scanAllForbiddenContent(INDEX_V2_JSON_PATH)
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated index — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  console.log(`\n✓ Index v2: ${INDEX_V2_JSON_PATH}`)
  console.log('✓ Human move memory index v2 build завършен успешно.\n')
  console.log('Следваща стъпка: npm run analyze:human-move-memory-v2\n')
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(2)
})
