// Phase 0B — bounded, code-defined HTTP route-family labels за main-thread
// timing forensics. Таблицата е изведена от фиксираните route matcher-и в
// index.ts / games/svara (литерални pathname сравнения и regex-и с
// параметри) и е ЗАМРАЗЕНА тук — label-ът винаги идва от нея, никога от
// заявката. ':id' хваща точно един непразен сегмент; стойността му никога
// не влиза в label-а.
//
// Label формат: '<METHOD>.<template без /api/, '/' -> '.', ':id' -> '_'>',
// напр. 'POST.tournaments._.join'. Непознат път -> '<METHOD>.<category>.other'
// (category от httpCategoryClassifier). Методът е от фиксиран списък.
//
// Нов HTTP route без запис тук пак е bounded (попада в '<category>.other');
// добави template, за да получи собствен label.

import { classifyHttpRequestPath } from './httpCategoryClassifier.js'

export const HTTP_ROUTE_TEMPLATES: readonly string[] = [
  '/api/account/change-password',
  '/api/admin/ad-campaigns',
  '/api/admin/ad-campaigns/:id',
  '/api/admin/ad-campaigns/:id/send',
  '/api/admin/bundle-packages',
  '/api/admin/bundle-packages/:id',
  '/api/admin/bundle-packages/:id/status',
  '/api/admin/campaigns',
  '/api/admin/campaigns/:id',
  '/api/admin/campaigns/:id/:id',
  '/api/admin/campaigns/:id/archive',
  '/api/admin/campaigns/:id/theme-assets/:id',
  '/api/admin/campaigns/archive',
  '/api/admin/coin-packages',
  '/api/admin/coin-packages/:id',
  '/api/admin/coin-packages/:id/lobby',
  '/api/admin/coin-packages/:id/status',
  '/api/admin/coin-packages/:id/top-offer',
  '/api/admin/daily-rewards',
  '/api/admin/daily-rewards/:id',
  '/api/admin/gift-items',
  '/api/admin/gift-items/:id',
  '/api/admin/gift-items/:id/status',
  '/api/admin/gift-items/upload-image',
  '/api/admin/guest-contact/messages',
  '/api/admin/guest-contact/messages/:id',
  '/api/admin/guest-contact/messages/:id/read',
  '/api/admin/guest-contact/messages/unread-count',
  '/api/admin/missions',
  '/api/admin/missions/:id',
  '/api/admin/missions/:id/active',
  '/api/admin/monitoring/connections',
  '/api/admin/monitoring/cpu-incidents',
  '/api/admin/monitoring/cpu-incidents/:id',
  '/api/admin/monitoring/current',
  '/api/admin/monitoring/history',
  '/api/admin/payments',
  '/api/admin/payments/:id',
  '/api/admin/profiles/:id',
  '/api/admin/profiles/:id/avatar',
  '/api/admin/profiles/:id/ban',
  '/api/admin/profiles/:id/chat-admin',
  '/api/admin/profiles/:id/display-name',
  '/api/admin/profiles/:id/gallery/:id',
  '/api/admin/profiles/:id/marketing',
  '/api/admin/profiles/:id/pika-team',
  '/api/admin/profiles/:id/risk-detail',
  '/api/admin/profiles/:id/risk-recheck',
  '/api/admin/profiles/:id/subadmin',
  '/api/admin/profiles/:id/top-chat-admin',
  '/api/admin/profiles/:id/vip-grant',
  '/api/admin/registered-profiles',
  '/api/admin/rooms',
  '/api/admin/rooms/:id',
  '/api/admin/settings',
  '/api/admin/stats',
  '/api/admin/topic-reports',
  '/api/admin/topic-reports/:id/review',
  '/api/admin/topics/:id/moderation-log',
  '/api/admin/tournaments',
  '/api/admin/tournaments/:id',
  '/api/admin/tournaments/:id/cancel-open',
  '/api/admin/tournaments/:id/reconcile',
  '/api/admin/visitor-sources',
  '/api/admin/visitors',
  '/api/auth/cancel-pending-registration',
  '/api/auth/forgot-password',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/register',
  '/api/auth/registration-verification-status',
  '/api/auth/resend-registration-code',
  '/api/auth/reset-password',
  '/api/auth/update-pending-registration-display-name',
  '/api/auth/verify-registration-email',
  '/api/blocks',
  '/api/campaign-reward-notifications/:id/ack',
  '/api/chat/:id/attachments/:id',
  '/api/chat/:id/messages',
  '/api/chat/:id/messages/:id',
  '/api/chat/:id/read',
  '/api/chat/conversations',
  '/api/chat/pika-support/start',
  '/api/chat/vip-dm/start',
  '/api/chat/vip-dm/start-with-message',
  '/api/contact/guest',
  '/api/daily-rewards',
  '/api/daily-rewards/claim',
  '/api/friends',
  '/api/friends/:id/accept',
  '/api/friends/:id/cancel',
  '/api/friends/:id/gift-coins',
  '/api/friends/:id/read-acceptance',
  '/api/friends/:id/reject',
  '/api/friends/:id/remove',
  '/api/friends/gift-coins/direct',
  '/api/friends/request',
  '/api/games/svara/access',
  '/api/gift-items',
  '/api/gift-items/deliveries/:id/mark-shown',
  '/api/gifts/:id/read-notification',
  '/api/guest/trial-status',
  '/api/leaderboards',
  '/api/lobby-chat/messages/:id',
  '/api/lobby/packages',
  '/api/missions/:id/claim',
  '/api/missions/daily',
  '/api/paid-gift-notifications/bundle/:id/ack',
  '/api/paid-gift-notifications/coin/:id/ack',
  '/api/paid-gift-notifications/vip/:id/ack',
  '/api/players',
  '/api/players/search',
  '/api/profile/:id/send-gift-item',
  '/api/profile/check-name',
  '/api/profile/me',
  '/api/profile/me/avatar',
  '/api/profile/me/display-name',
  '/api/profile/me/gallery',
  '/api/profile/me/gallery/:id',
  '/api/profiles/:id',
  '/api/profiles/:id/block',
  '/api/profiles/:id/campaign-summary',
  '/api/profiles/:id/like',
  '/api/rooms',
  '/api/settings/public',
  '/api/shop/bundle-checkout',
  '/api/shop/bundle-packages',
  '/api/shop/bundle-purchases',
  '/api/shop/bundle-purchases/:id/hide',
  '/api/shop/checkout',
  '/api/shop/packages',
  '/api/shop/purchases',
  '/api/shop/purchases/:id/hide',
  '/api/shop/purchases/:id/resume-checkout',
  '/api/stripe/webhook',
  '/api/support/admin/conversations',
  '/api/support/admin/conversations/:id',
  '/api/support/admin/conversations/:id/archive',
  '/api/support/admin/conversations/:id/unarchive',
  '/api/support/admin/messages/:id',
  '/api/support/admin/reply',
  '/api/support/attachments/:id',
  '/api/support/messages',
  '/api/support/unread',
  '/api/topics',
  '/api/topics/:id',
  '/api/topics/:id/attachments/:id',
  '/api/topics/:id/lock',
  '/api/topics/:id/messages',
  '/api/topics/:id/messages/:id',
  '/api/topics/:id/messages/:id/replies',
  '/api/topics/:id/messages/:id/seen',
  '/api/topics/:id/mute',
  '/api/topics/:id/mute-status',
  '/api/topics/:id/report',
  '/api/topics/:id/seen',
  '/api/topics/:id/unlock',
  '/api/topics/:id/unmute',
  '/api/topics/mute-evidence/attachments/:id',
  '/api/topics/mute-evidence/mine',
  '/api/topics/mute-evidence/profile/:id',
  '/api/topics/mute-status',
  '/api/topics/profile-mute',
  '/api/topics/unmute',
  '/api/tournaments',
  '/api/tournaments/:id',
  '/api/tournaments/:id/acknowledge-bot-return',
  '/api/tournaments/:id/cancel',
  '/api/tournaments/:id/entries/:id/remove',
  '/api/tournaments/:id/join',
  '/api/tournaments/:id/leave',
  '/api/tournaments/:id/partner-candidates',
  '/api/tournaments/:id/partner-candidates/search',
  '/api/tournaments/:id/partner-invites',
  '/api/tournaments/:id/partner-invites/:id/accept',
  '/api/tournaments/:id/partner-invites/:id/cancel',
  '/api/tournaments/:id/partner-invites/:id/decline',
  '/api/tournaments/:id/scheduled-start',
  '/api/tournaments/:id/teams/:id/remove',
  '/api/tournaments/beta-access',
  '/api/tournaments/partner-invites/:id/dismiss-popup',
  '/api/tournaments/partner-invites/:id/view',
  '/api/tournaments/partner-invites/pending',
  '/api/vip/checkout',
  '/api/vip/claim-launch-gift',
  '/api/vip/packages',
  '/api/vip/purchases',
  '/api/vip/status',
  '/api/visits/page-view',
  '/health',
]

const HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const UPLOADS_PREFIX = '/uploads/'
const API_PREFIX = '/api/'

type CompiledTemplate = { segments: readonly string[]; label: string; params: number }

export function httpRouteTemplateToLabel(template: string): string {
  const path = template.startsWith(API_PREFIX) ? template.slice(API_PREFIX.length) : template.slice(1)
  return path.split('/').map((segment) => (segment === ':id' ? '_' : segment)).join('.')
}

function indexKey(segments: readonly string[]): string {
  return `${segments.length}:${segments[1] ?? ''}`
}

// Индекс по (брой сегменти, първи сегмент след api); литералните шаблони са
// преди параметричните, за да печели най-специфичният ('topics/mute-status'
// преди 'topics/:id').
const templatesByKey = new Map<string, CompiledTemplate[]>()
for (const template of HTTP_ROUTE_TEMPLATES) {
  const segments = template.split('/').slice(1)
  const compiled: CompiledTemplate = {
    segments,
    label: httpRouteTemplateToLabel(template),
    params: segments.filter((segment) => segment === ':id').length,
  }
  const key = indexKey(segments)
  const list = templatesByKey.get(key) ?? []
  list.push(compiled)
  templatesByKey.set(key, list)
}
for (const list of templatesByKey.values()) list.sort((a, b) => a.params - b.params)

function matchTemplate(segments: readonly string[]): string | null {
  const candidates = templatesByKey.get(indexKey(segments))
  if (candidates === undefined) return null
  for (const candidate of candidates) {
    let matches = true
    for (let i = 0; i < segments.length; i += 1) {
      const expected = candidate.segments[i]!
      const actual = segments[i]!
      if (expected === ':id' ? actual.length === 0 : expected !== actual) {
        matches = false
        break
      }
    }
    if (matches) return candidate.label
  }
  return null
}

export function classifyHttpRoute(method: string | undefined, rawUrl: string | undefined): string {
  const safeMethod = method !== undefined && HTTP_METHODS.has(method) ? method : 'OTHER'
  const url = rawUrl ?? '/'
  const queryIndex = url.indexOf('?')
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
  if (pathname.startsWith(UPLOADS_PREFIX)) return `${safeMethod}.uploads.static`
  const label = matchTemplate(pathname.split('/').slice(1))
  return label !== null ? `${safeMethod}.${label}` : `${safeMethod}.${classifyHttpRequestPath(pathname)}.other`
}
