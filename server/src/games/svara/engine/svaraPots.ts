// Свара — основна и странични банки (чиста логика, Етап 2Б.2А).
//
// Вход: колко е внесъл всеки участник в раздаването (анте + залози) и кои
// са се отказали. Изход: слоеве (банки) с точна сума, вносители и изрично
// записани правоимащи.
//
// Алгоритъм: нивата са всички различни вноски (вкл. на отказалите се).
// За слой (долно, горно] всеки играч внася min(вноска, горно) −
// min(вноска, долно) — включително отказалите се, чиито чипове остават в
// банката. Правоимащи са само неотказалите играчи, чиято вноска достига
// горното ниво. Накрая съседните спорни слоеве с еднакви правоимащи се
// сливат в една банка (нивата на отказалите се не създават нови банки).
// Нивата на отказалите се са нужни, за да се отдели точно непокритата
// част: A 50 (отказал), B 50 (отказал), C 120 → (0,50] = 150 присъдена на
// C, (50,120] = 70 върната на C.
//
// Строго разграничение:
//   • 'uncalled'  — в слоя е внесъл точно един играч: непокрита част от
//                   залог; връща се на него и НЕ е печалба.
//   • 'contested' — внесли са поне двама; присъжда се на правоимащ
//                   (един — без сравняване; няколко — по картите).

import { SvaraInvalidInputError } from './svaraCards.js'
import type { SvaraPlayerId } from './svaraDeal.js'

export type SvaraPotLayerKind = 'uncalled' | 'contested'

export type SvaraPotLayer = {
  /** 0 = основна банка, 1.. = странични (по нарастващо ниво). */
  index: number
  /** Долно ниво (изключено) и горно ниво (включено) на вноската. */
  fromLevel: number
  toLevel: number
  amount: number
  /** Чипове на всеки вносител в този слой (само > 0), по реда на участниците. */
  contributions: Readonly<Record<SvaraPlayerId, number>>
  contributors: readonly SvaraPlayerId[]
  /** Неотказали играчи с вноска ≥ toLevel, по реда на участниците. */
  eligible: readonly SvaraPlayerId[]
  kind: SvaraPotLayerKind
}

export type SvaraPotInput = {
  participants: readonly SvaraPlayerId[]
  contributions: Readonly<Record<SvaraPlayerId, number>>
  folded: readonly SvaraPlayerId[]
}

function assertChipAmount(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SvaraInvalidInputError(`${label}: expected a non-negative integer, got ${String(value)}`)
  }
}

export function buildSvaraPotLayers(input: SvaraPotInput): SvaraPotLayer[] {
  const { participants, contributions, folded } = input
  if (!Array.isArray(participants) || participants.length === 0) throw new SvaraInvalidInputError('pots: participants required')
  if (new Set(participants).size !== participants.length) throw new SvaraInvalidInputError('pots: duplicate participant')
  for (const id of Object.keys(contributions)) {
    if (!participants.includes(id)) throw new SvaraInvalidInputError(`pots: contribution from non-participant ${id}`)
  }
  for (const id of folded) {
    if (!participants.includes(id)) throw new SvaraInvalidInputError(`pots: folded non-participant ${id}`)
  }
  const foldedSet = new Set(folded)
  const amountOf = (id: SvaraPlayerId) => {
    const value = contributions[id] ?? 0
    assertChipAmount(value, `pots: contribution of ${id}`)
    return value
  }

  const all = participants.map(amountOf)
  const maxContribution = Math.max(0, ...all)
  if (maxContribution === 0) return []
  const levels = new Set<number>(all.filter((value) => value > 0))

  const raw: SvaraPotLayer[] = []
  let previous = 0
  for (const level of [...levels].sort((a, b) => a - b)) {
    const layerContributions: Record<SvaraPlayerId, number> = {}
    let amount = 0
    for (const id of participants) {
      const value = amountOf(id)
      const part = Math.min(value, level) - Math.min(value, previous)
      if (part > 0) {
        layerContributions[id] = part
        amount += part
      }
    }
    const contributors = participants.filter((id) => (layerContributions[id] ?? 0) > 0)
    raw.push({
      index: raw.length,
      fromLevel: previous,
      toLevel: level,
      amount,
      contributions: Object.freeze(layerContributions),
      contributors: Object.freeze(contributors),
      eligible: Object.freeze(participants.filter((id) => !foldedSet.has(id) && amountOf(id) >= level)),
      kind: contributors.length === 1 ? 'uncalled' : 'contested',
    })
    previous = level
  }

  // Сливане на съседни спорни слоеве с еднакви правоимащи.
  const layers: SvaraPotLayer[] = []
  for (const layer of raw) {
    const last = layers[layers.length - 1]
    const sameEligible = last !== undefined && last.eligible.length === layer.eligible.length && last.eligible.every((id, i) => id === layer.eligible[i])
    if (last && last.kind === 'contested' && layer.kind === 'contested' && sameEligible) {
      const merged: Record<SvaraPlayerId, number> = { ...last.contributions }
      for (const [id, part] of Object.entries(layer.contributions)) merged[id] = (merged[id] ?? 0) + part
      layers[layers.length - 1] = {
        ...last,
        toLevel: layer.toLevel,
        amount: last.amount + layer.amount,
        contributions: Object.freeze(merged),
        contributors: Object.freeze(participants.filter((id) => (merged[id] ?? 0) > 0)),
      }
    } else {
      layers.push({ ...layer, index: layers.length })
    }
  }
  return layers
}
