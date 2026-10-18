// Свара — глас „Бягам!“ при ДОБРОВОЛЕН отказ (Етап 2Б.3.7.5, задание §12).
// Собственикът ще предостави реалните аудиофайлове по-късно — засега само
// безопасно място за включването им: ако пола е неизвестен ИЛИ файлът не
// успее да проиграе (липсва/грешка), функцията тихо не прави нищо — никога
// грешка, никога блокиране на играта (задание §12 "не допускай липсващ файл
// да предизвиква грешка или да блокира играта"). playGameSound() вече
// поглъща play()-грешки тихо (виж gameSoundSettings.ts), затова няма нужда
// от допълнителна проверка тук — просто се доверяваме на същата гаранция.
//
// Избор на глас: ЕДИНСТВЕНО по изрично зададения пол в профила, ако е
// предоставен от повикващия — никога по име/аватар/предположение (задание
// §12 "не определяй пола по име, аватар или други предположения"). Реалният
// Свара snapshot/публична маса днес НЕ носи пол на играч (виж коментара в
// svaraTableAssets.ts — няма displayName/avatarUrl/gender в
// SvaraSnapshotSeat/SvaraPublicTable.players); затова всички текущи call
// site-ове подават gender: null, а функцията просто показва само балончето
// (виж renderSvaraActiveTable.ts/createSvaraLobbyController.ts) — очаквано,
// не бъг. Белот вече носи gender в RoomSeatSnapshot (createRoomSnapshotMessage.ts) —
// добавянето на огледално поле в SvaraSnapshotSeat/SvaraPublicTable е
// минимално бъдещо разширение, ако собственикът поиска реален глас по пол,
// но не е направено тук (няма реални аудиофайлове все още).
//
// Задължително уважава съществуващата глобална "Звуци по време на игра"
// настройка (playGameSound() вече го прави) — не въвежда нов toggle, не
// променя поведението на Белот/Ludo звуците.

import { playGameSound } from '../../../audio/gameSoundSettings'

export type SvaraPlayerGender = 'male' | 'female' | null

// Placeholder пътища — НЕ истински записи (собственикът ще ги предостави).
const FOLD_VOICE_SRC: Record<'male' | 'female', string> = {
  male: '/audio/game-sounds/svara-fold-male.mp3',
  female: '/audio/game-sounds/svara-fold-female.mp3',
}

/**
 * Пуска гласа „Бягам!“ за ДОБРОВОЛЕН отказ, само ако gender е известен.
 * Никога за принудителен отказ (timeout/отсъствие) — виж заданието §13 "Не
 * се възпроизвежда гласът 'Бягам!'" и повикването в createSvaraLobbyController.ts
 * (само от voluntary-fold пътя).
 */
export function playSvaraFoldVoice(gender: SvaraPlayerGender): void {
  if (gender === null) return
  playGameSound(FOLD_VOICE_SRC[gender], { volume: 0.7 })
}
