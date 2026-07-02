import { resolve } from 'node:path'

export type TrainingRecorderConfig = {
  enabled: boolean
  storagePath: string
  hashSecret: string
  maxFileMb: number
  maxTotalGb: number
  maxQueue: number
  retentionDays: number
  processId: string
  workerId: string
}

const DEFAULT_STORAGE_PATH = './training-recordings'
const DEFAULT_MAX_FILE_MB = 100
const DEFAULT_MAX_TOTAL_GB = 10
const DEFAULT_MAX_QUEUE = 1000
const DEFAULT_RETENTION_DAYS = 90

function parsePositiveNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') return defaultValue
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : defaultValue
}

export function loadTrainingRecorderConfig(workerId: string = '0'): TrainingRecorderConfig {
  const enabled = process.env['TRAINING_RECORDER_ENABLED']?.trim().toLowerCase() === 'true'
  const storagePath = resolve(
    process.env['TRAINING_RECORDER_PATH']?.trim() || DEFAULT_STORAGE_PATH,
  )
  const hashSecret = process.env['TRAINING_RECORDER_HASH_SECRET']?.trim() ?? ''
  const maxFileMb = parsePositiveNumber(
    process.env['TRAINING_RECORDER_MAX_FILE_MB'],
    DEFAULT_MAX_FILE_MB,
  )
  const maxTotalGb = parsePositiveNumber(
    process.env['TRAINING_RECORDER_MAX_TOTAL_GB'],
    DEFAULT_MAX_TOTAL_GB,
  )
  const maxQueue = parsePositiveNumber(
    process.env['TRAINING_RECORDER_MAX_QUEUE'],
    DEFAULT_MAX_QUEUE,
  )
  const retentionDays = parsePositiveNumber(
    process.env['TRAINING_RECORDER_RETENTION_DAYS'],
    DEFAULT_RETENTION_DAYS,
  )

  return {
    enabled,
    storagePath,
    hashSecret,
    maxFileMb,
    maxTotalGb,
    maxQueue,
    retentionDays,
    processId: String(process.pid),
    workerId,
  }
}

export function validateTrainingRecorderConfig(
  config: TrainingRecorderConfig,
): { ok: true } | { ok: false; reason: string } {
  if (!config.enabled) {
    return { ok: true }
  }

  if (config.hashSecret.length < 16) {
    return {
      ok: false,
      reason:
        '[training-recorder] TRAINING_RECORDER_HASH_SECRET is missing or too short (min 16 chars). Recorder will not start.',
    }
  }

  // Path traversal guard
  if (config.storagePath.includes('..')) {
    return {
      ok: false,
      reason: '[training-recorder] TRAINING_RECORDER_PATH contains ".." — rejected for safety.',
    }
  }

  return { ok: true }
}
