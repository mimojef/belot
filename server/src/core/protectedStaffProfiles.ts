// Защитени от блокиране профили ("Екип Pika.bg").
//
// САМО account role 'pika_team' и 'marketing'. Нарочно НЕ admin, subadmin,
// chat_admin, top_chat_admin или player — модераторските/админ роли остават
// блокируеми. Ролята винаги се чете server-side от DB (accounts.role), никога
// от клиента.

import { OFFICIAL_PIKA_PROFILE_ID } from '../db/normalizeProfileIdentityText.js'

export const PROTECTED_STAFF_PROFILE_ERROR_CODE = 'PROTECTED_STAFF_PROFILE'

export const PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE = 'Не можете да блокирате профил от екипа на Pika.bg.'

export function isProtectedStaffRole(role: string | null | undefined): boolean {
  return role === 'pika_team' || role === 'marketing'
}

// Защитени от МЮТ профили — ОТДЕЛНО правило от блокирането по-горе
// (isProtectedStaffRole остава непроменено за block). Мютът не може да бъде
// наложен на admin, pika_team ("Екип Pika.bg"), marketing или официалния
// профил Pika.bg (по ID, никога по display name). Ролята винаги идва
// server-side от accounts.role.
export const PROTECTED_STAFF_PROFILE_MUTE_MESSAGE = 'Не можете да заглушите профил от екипа на Pika.bg.'

export function isMuteProtectedStaffTarget(role: string | null | undefined, profileId: string): boolean {
  return (
    role === 'admin' ||
    role === 'pika_team' ||
    role === 'marketing' ||
    profileId === OFFICIAL_PIKA_PROFILE_ID
  )
}
