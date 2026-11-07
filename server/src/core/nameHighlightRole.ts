// Роли, чиито никове се оцветяват с отличителен цвят в "Лафче", "Теми"
// (публикации + отговори) и личните чатове. Клиентът мапва ролята към
// конкретния цвят (src/app/lobby/roleNicknameColor.ts) — сървърът само
// съобщава ТЕКУЩАТА роля на автора/събеседника, стеснена до този списък,
// за да не разкрива другите роли (admin/subadmin/...) там, където досега
// не са били видими.
//
// Derived at read time (като senderAvatarUrl), НЕ role-at-write snapshot:
// topic_messages.sender_role умишлено записва 'marketing' като 'player'
// (виж getTopicAuthorRoleSnapshotForProfile в index.ts) и DB CHECK-ът не
// допуска 'marketing' — затова оцветяването не може да се базира на него.
export const NAME_HIGHLIGHT_ROLES = ['top_chat_admin', 'marketing'] as const

export type NameHighlightRole = typeof NAME_HIGHLIGHT_ROLES[number]

export function toNameHighlightRole(role: string | null | undefined): NameHighlightRole | null {
  return role === 'top_chat_admin' || role === 'marketing' ? role : null
}
