// Гласов чат — неповторими имена на LiveKit стаите (Етап 2а; само данни).
//
// Формат: pv_<voiceTableId без тирета>_g<generation>_<26 base32 символа>
//   * префиксът pv_ позволява reconciliation по префикс (ListRooms в Етап 2б):
//     всяка pv_ стая, която НЕ е текущата 'live' генерация на активна маса, се
//     прекратява — включително стая, възкресена от забавен CreateRoom;
//   * генерацията е монотонна за масата;
//   * 128 бита случайност гарантират, че име никога не се повтаря, дори при
//     загуба на базата.
// Името е видимо за клиента (в токена) — не съдържа profileId, privateRoomId
// или ServerRoom.id.

import { randomBytes } from 'node:crypto'

export const VOICE_ROOM_NAME_PREFIX = 'pv_'

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const RANDOM_SUFFIX_LENGTH = 26 // 26 * 5 = 130 бита >= 128 бита от 16 байта

const VOICE_ROOM_NAME_PATTERN = /^pv_([0-9a-f]{32})_g([1-9][0-9]{0,8})_([a-z2-7]{26})$/
const VOICE_TABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function encodeBase32(bytes: Buffer, length: number): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && output.length < length) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0 && output.length < length) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output.padEnd(length, 'a')
}

export function isVoiceTableId(value: unknown): value is string {
  return typeof value === 'string' && VOICE_TABLE_ID_PATTERN.test(value)
}

export function buildVoiceRoomName(
  voiceTableId: string,
  generation: number,
  randomSource: (size: number) => Buffer = randomBytes,
): string {
  if (!isVoiceTableId(voiceTableId)) throw new Error('voice_room_name_invalid_table_id')
  if (!Number.isInteger(generation) || generation < 1 || generation > 999_999_999) {
    throw new Error('voice_room_name_invalid_generation')
  }
  const suffix = encodeBase32(randomSource(17), RANDOM_SUFFIX_LENGTH)
  return `${VOICE_ROOM_NAME_PREFIX}${voiceTableId.replaceAll('-', '')}_g${generation}_${suffix}`
}

export type ParsedVoiceRoomName = {
  compactVoiceTableId: string
  generation: number
}

/** null за всичко, което не е точно наш формат (чужди стаи не се пипат по погрешка). */
export function parseVoiceRoomName(name: string): ParsedVoiceRoomName | null {
  const match = VOICE_ROOM_NAME_PATTERN.exec(name)
  if (match === null) return null
  return { compactVoiceTableId: match[1]!, generation: Number(match[2]) }
}
