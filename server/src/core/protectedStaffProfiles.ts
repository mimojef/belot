// Защитени от блокиране профили ("Екип Pika.bg").
//
// САМО account role 'pika_team' и 'marketing'. Нарочно НЕ admin, subadmin,
// chat_admin, top_chat_admin или player — модераторските/админ роли остават
// блокируеми. Ролята винаги се чете server-side от DB (accounts.role), никога
// от клиента.

export const PROTECTED_STAFF_PROFILE_ERROR_CODE = 'PROTECTED_STAFF_PROFILE'

export const PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE = 'Не можете да блокирате профил от екипа на Pika.bg.'

export function isProtectedStaffRole(role: string | null | undefined): boolean {
  return role === 'pika_team' || role === 'marketing'
}
