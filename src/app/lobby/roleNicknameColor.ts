// Обща логика за отличителния цвят на ника по роля — ползва се в "Лафче",
// "Теми" (публикации + отговори) и личните чатове, и в десктоп, и в новия
// мобилен (светъл) интерфейс. Ролята идва от сървъра като ТЕКУЩА роля на
// автора/събеседника, стеснена до ролите с отличителен цвят
// (TopicMessageSnapshot.senderNameHighlightRole /
// ChatConversationSnapshot.friendNameHighlightRole).
//
// Цветът на ролята има приоритет пред VIP статус и стандартното (златисто/
// тъмно) оцветяване — caller-ът го ползва вместо подразбиращия се цвят,
// когато резултатът не е null. Всички други роли → null (цветът им не се
// променя).

export type NicknameHighlightRole = 'pika_team' | 'marketing'

/** Ярко, наситено цикламенорозово — еднакво за pika_team и marketing. */
export const ROLE_NICKNAME_HIGHLIGHT_COLOR = '#F72585'

export function getRoleNicknameColor(role: string | null | undefined): string | null {
  return role === 'pika_team' || role === 'marketing' ? ROLE_NICKNAME_HIGHLIGHT_COLOR : null
}
