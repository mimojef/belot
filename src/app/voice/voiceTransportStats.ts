// Гласов чат — Етап 6: обобщение на WebRTC статистиката за админ панела.
//
// Чиста функция (без livekit-client) върху RTCStatsReport на аудио track:
// вид и протокол на избраната ICE двойка (relay = през TURN) и закръглени
// RTT / jitter / загуба на пакети. Без адреси, портове и IP — те никога не
// напускат браузъра.

import type { VoiceTransportInfo } from './voiceAdapter'

type StatsEntry = Record<string, unknown> & { type?: unknown; id?: unknown }

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function round(value: number | null, max: number): number | null {
  if (value === null || value > max) return null
  return Math.round(value * 100) / 100
}

/** report — RTCStatsReport (Map-like) или масив от записи (тестове). */
export function summarizeTransportStats(report: { forEach: (callback: (entry: unknown) => void) => void } | readonly unknown[]): VoiceTransportInfo | null {
  const entries: StatsEntry[] = []
  const collect = (entry: unknown): void => {
    if (typeof entry === 'object' && entry !== null) entries.push(entry as StatsEntry)
  }
  if (Array.isArray(report)) report.forEach(collect)
  else (report as { forEach: (callback: (entry: unknown) => void) => void }).forEach(collect)
  if (entries.length === 0) return null
  const byId = new Map<string, StatsEntry>()
  for (const entry of entries) {
    const id = str(entry.id)
    if (id !== null) byId.set(id, entry)
  }

  // Избраната двойка: transport.selectedCandidatePairId (Chrome/Safari),
  // иначе candidate-pair с selected (Firefox) / nominated+succeeded.
  let pair: StatsEntry | undefined
  for (const entry of entries) {
    if (entry.type !== 'transport') continue
    const selectedId = str(entry.selectedCandidatePairId)
    if (selectedId !== null) pair = byId.get(selectedId)
    if (pair !== undefined) break
  }
  pair ??= entries.find((entry) => entry.type === 'candidate-pair' && entry.selected === true)
  pair ??= entries.find((entry) => entry.type === 'candidate-pair' && entry.nominated === true && entry.state === 'succeeded')

  let candidateType: VoiceTransportInfo['candidateType'] = 'unknown'
  let protocol: VoiceTransportInfo['protocol'] = 'unknown'
  if (pair !== undefined) {
    const local = byId.get(str(pair.localCandidateId) ?? '')
    const type = str(local?.candidateType)
    if (type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay') candidateType = type
    // За relay — протоколът до TURN сървъра (udp/tcp/tls), иначе на кандидата.
    const rawProtocol = (candidateType === 'relay' ? str(local?.relayProtocol) : null) ?? str(local?.protocol)
    if (rawProtocol === 'udp' || rawProtocol === 'tcp' || rawProtocol === 'tls') protocol = rawProtocol
  }

  const rttSeconds = num(pair?.currentRoundTripTime)
  // Входящо аудио (слушател) или отчет на отсрещната страна за изходящото (говорещ).
  const inbound = entries.find((entry) => entry.type === 'inbound-rtp' && (entry.kind === 'audio' || entry.mediaType === 'audio'))
  const remoteInbound = entries.find((entry) => entry.type === 'remote-inbound-rtp' && (entry.kind === 'audio' || entry.mediaType === 'audio'))
  const jitterSeconds = num(inbound?.jitter) ?? num(remoteInbound?.jitter)
  let packetLossPercent: number | null = null
  const lost = num(inbound?.packetsLost)
  const received = num(inbound?.packetsReceived)
  if (lost !== null && received !== null && lost + received > 0) packetLossPercent = (lost / (lost + received)) * 100
  else {
    const fraction = num(remoteInbound?.fractionLost)
    if (fraction !== null) packetLossPercent = fraction * 100
  }
  const remoteRtt = num(remoteInbound?.roundTripTime)

  return {
    candidateType,
    protocol,
    rttMs: round((rttSeconds ?? remoteRtt) === null ? null : (rttSeconds ?? remoteRtt)! * 1000, 60_000),
    jitterMs: round(jitterSeconds === null ? null : jitterSeconds * 1000, 60_000),
    packetLossPercent: round(packetLossPercent, 100),
  }
}
