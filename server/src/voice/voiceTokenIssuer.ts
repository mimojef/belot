// Гласов чат — подписване на клиентски LiveKit токени (Етап 2б).
//
// Ползва ОФИЦИАЛНИЯ AccessToken API на livekit-server-sdk (HS256). toJwt()
// е асинхронен — caller-ът (voiceChatService.ts) прави окончателна
// синхронна проверка на правата СЛЕД подписа и непосредствено преди да
// предаде токена; ако състоянието се е променило, токенът се изхвърля.
//
// Правилата за grants (точни, без административни права):
//   говорене:  roomJoin, room=<точно име>, canSubscribe:true, canPublish:true,
//              canPublishSources:['microphone'], canPublishData:false
//   слушане:   roomJoin, room=<точно име>, canSubscribe:true, canPublish:false,
//              canPublishSources:[], canPublishData:false
//   винаги:    canUpdateOwnMetadata:false, hidden:false, recorder:false;
//              НИКОГА roomCreate / roomAdmin / roomList / roomRecord /
//              ingressAdmin / agent / destinationRoom.
// Без name/metadata/attributes в токена — LiveKit не съхранява имена.
// Токенът НЕ се логва, не се записва в базата и не минава през WebSocket.

import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk'
import type { VoiceLiveKitPermissionProfile } from './voiceChatTypes.js'

/** Валидност само за влизане; връзката се поддържа с refresh токени от LiveKit. */
export const VOICE_TOKEN_TTL_SECONDS = 600

/** Чиста функция — точният grant за стаята (тестваема без подпис). */
export function buildVoiceVideoGrant(roomName: string, permission: VoiceLiveKitPermissionProfile): VideoGrant {
  return {
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    canPublish: permission.canPublish,
    canPublishSources: permission.canPublish ? [TrackSource.MICROPHONE] : [],
    canPublishData: false,
    canUpdateOwnMetadata: false,
    hidden: false,
    recorder: false,
  }
}

/**
 * LiveKit identity: p_<profileId>_<bindingEpoch>. Епохата различава
 * сесиите на един и същ профил (refresh/друго устройство), за да не може
 * стар токен да изхвърли актуалния участник чрез DUPLICATE_IDENTITY.
 */
export function buildVoiceIdentity(profileId: string, bindingEpoch: number): string {
  return `p_${profileId}_${bindingEpoch}`
}

export type VoiceTokenSigner = (input: {
  identity: string
  roomName: string
  permission: VoiceLiveKitPermissionProfile
}) => Promise<string>

export function createVoiceTokenSigner(credentials: { apiKey: string; apiSecret: string }, ttlSeconds: number = VOICE_TOKEN_TTL_SECONDS): VoiceTokenSigner {
  return async ({ identity, roomName, permission }) => {
    const token = new AccessToken(credentials.apiKey, credentials.apiSecret, { identity, ttl: ttlSeconds })
    token.addGrant(buildVoiceVideoGrant(roomName, permission))
    return token.toJwt()
  }
}
