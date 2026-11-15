// Тестова страница (само за scripts/checkVoiceRealLiveKitE2E.ts): директно
// влизане в LiveKit с даден токен чрез официалния livekit-client — без
// гласовия контролер на Pika. Доказва какво може да направи притежател на
// стар токен: влиза ли изобщо и получава ли аудио пакети от участниците.

import { Room, RoomEvent, Track } from 'livekit-client'

type ProbeResult = { joined: boolean; error: string | null; audioTracks: number; packets: number }

async function join(url: string, token: string, listenMs: number): Promise<ProbeResult> {
  const room = new Room({ adaptiveStream: false, dynacast: false })
  let audioTracks = 0
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) audioTracks += 1
  })
  try {
    await room.connect(url, token, { autoSubscribe: true, maxRetries: 0 })
  } catch (error) {
    return { joined: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 160), audioTracks: 0, packets: 0 }
  }
  await new Promise((resolve) => setTimeout(resolve, listenMs))
  let packets = 0
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const receiver = (publication.track as unknown as { receiver?: RTCRtpReceiver } | undefined)?.receiver
      if (receiver === undefined) continue
      const stats = await receiver.getStats()
      stats.forEach((entry: { type?: string; kind?: string; packetsReceived?: number }) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'audio') packets += entry.packetsReceived ?? 0
      })
    }
  }
  await room.disconnect()
  return { joined: true, error: null, audioTracks, packets }
}

;(window as unknown as { __liveKitProbe: { join: typeof join } }).__liveKitProbe = { join }
