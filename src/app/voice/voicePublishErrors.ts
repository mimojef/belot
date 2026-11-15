// Гласов чат — клас на грешка при публикуване на микрофона в LiveKit.
//
// Само по име / код / статус на грешката на SDK-то (livekit-client 2.x);
// текстът на грешката не се пази и не се изпраща никъде. Без импорт на
// livekit-client — тества се директно (scripts/checkVoiceMicAcquisition.ts).
//
//   cancelled     — пълен reconnect отмени незавършеното addTrack
//                   („Cancelled publication by calling unpublish“);
//   timeout       — няма отговор от сървъра / двигателят не се свърза навреме;
//   negotiation   — неуспешно WebRTC договаряне (NegotiationError);
//   not_connected — стаята/двигателят не е свързан (UnexpectedConnectionState);
//   not_permitted — няма право за публикуване (PublishTrackError 403,
//                   „insufficient permissions“) — потвърден отказ на правата;
//   other         — всичко останало.

import type { VoicePublishErrorKind } from './voiceAdapter'

export function classifyPublishError(error: unknown): VoicePublishErrorKind {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: unknown }).status : undefined
  if (status === 403 || /insufficient permissions|not allowed to publish|permission denied/i.test(message)) return 'not_permitted'
  if (/cancelled publication/i.test(message)) return 'cancelled'
  if (name === 'NegotiationError') return /timed out/i.test(message) ? 'timeout' : 'negotiation'
  if (status === 408 || /timed out|timeout/i.test(message)) return 'timeout'
  if (name === 'UnexpectedConnectionState' || /not connected|closed engine|pc ?manager/i.test(message)) return 'not_connected'
  return 'other'
}
