/**
 * Помощен процес за checkVoiceChatStage2a.ts — симулира отделен PM2 instance
 * със собствена SQLite връзка, който резервира гласови маси ЕДНОВРЕМЕННО с
 * други процеси. Не се ползва в production.
 *
 *   tsx scripts/fixtures/voiceChatReserveChild.ts <dbPath> <startAtEpochMs> <attempts>
 *
 * Печата един JSON ред: { reserved: string[], capacity: number, busy: number }.
 */

import { createVoiceChatStore } from '../../src/voice/voiceChatStore.js'

const [dbPath, startAtRaw, attemptsRaw] = process.argv.slice(2)
if (dbPath === undefined || startAtRaw === undefined || attemptsRaw === undefined) {
  console.error('usage: voiceChatReserveChild.ts <dbPath> <startAtEpochMs> <attempts>')
  process.exit(2)
}

const store = await createVoiceChatStore(dbPath, { busyTimeoutMs: 5_000 })
const startAt = Number(startAtRaw)
const attempts = Number(attemptsRaw)

// Синхронизиран старт на всички процеси.
while (Date.now() < startAt) {
  await new Promise((resolve) => setTimeout(resolve, 1))
}

const reserved: string[] = []
let capacity = 0
let busy = 0
for (let index = 0; index < attempts; index += 1) {
  // busy се повтаря — целта е реална конкуренция до края на капацитета.
  for (;;) {
    const result = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (result.ok) {
      reserved.push(result.table.voiceTableId)
      break
    }
    if (result.code === 'busy') {
      busy += 1
      continue
    }
    if (result.code === 'capacity_reached') capacity += 1
    break
  }
}

store.close()
process.stdout.write(`${JSON.stringify({ reserved, capacity, busy })}\n`)
