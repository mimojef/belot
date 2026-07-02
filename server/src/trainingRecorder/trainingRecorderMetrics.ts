export type TrainingRecorderMetrics = {
  enabled: boolean
  healthy: boolean
  queuedRecords: number
  writtenRecords: number
  droppedRecords: number
  failedRecords: number
  duplicateDeals: number
  duplicateActions: number
  noActiveDeal: number
  invalidTransition: number
  currentFileBytes: number
  totalDirectoryBytes: number | null
  lastWriteAt: string | null
  lastErrorAt: string | null
}

export type MutableTrainingRecorderMetrics = {
  writtenRecords: number
  droppedRecords: number
  failedRecords: number
  duplicateDeals: number
  duplicateActions: number
  noActiveDeal: number
  invalidTransition: number
  currentFileBytes: number
  totalDirectoryBytes: number | null
  lastWriteAt: number | null
  lastErrorAt: number | null
  healthy: boolean
}

export function createMutableMetrics(): MutableTrainingRecorderMetrics {
  return {
    writtenRecords: 0,
    droppedRecords: 0,
    failedRecords: 0,
    duplicateDeals: 0,
    duplicateActions: 0,
    noActiveDeal: 0,
    invalidTransition: 0,
    currentFileBytes: 0,
    totalDirectoryBytes: null,
    lastWriteAt: null,
    lastErrorAt: null,
    healthy: true,
  }
}

export function snapshotMetrics(
  enabled: boolean,
  mutable: MutableTrainingRecorderMetrics,
  queueSize: number,
): TrainingRecorderMetrics {
  return {
    enabled,
    healthy: mutable.healthy,
    queuedRecords: queueSize,
    writtenRecords: mutable.writtenRecords,
    droppedRecords: mutable.droppedRecords,
    failedRecords: mutable.failedRecords,
    duplicateDeals: mutable.duplicateDeals,
    duplicateActions: mutable.duplicateActions,
    noActiveDeal: mutable.noActiveDeal,
    invalidTransition: mutable.invalidTransition,
    currentFileBytes: mutable.currentFileBytes,
    totalDirectoryBytes: mutable.totalDirectoryBytes,
    lastWriteAt: mutable.lastWriteAt !== null ? new Date(mutable.lastWriteAt).toISOString() : null,
    lastErrorAt:
      mutable.lastErrorAt !== null ? new Date(mutable.lastErrorAt).toISOString() : null,
  }
}
