// Fixed, finite pathname-prefix категоризация за HTTP metrics label-и.
// Изчислява се ВЕДНЪЖ, преди dispatch веригата в handleHttpRequest — не
// пипа route dispatch логиката (виж audit "B: pathname-prefix category").
// Никога не връща raw pathname/UUID сегмент — само едно от фиксираните имена.

export type HttpRequestCategory =
  | 'auth'
  | 'profile'
  | 'admin'
  | 'friends'
  | 'chat'
  | 'support'
  | 'topics'
  | 'players'
  | 'leaderboards'
  | 'shop'
  | 'vip'
  | 'tournaments'
  | 'missions'
  | 'dailyRewards'
  | 'uploads'
  | 'guest'
  | 'public'
  | 'health'
  | 'monitoring'
  | 'other'

const PREFIX_RULES: ReadonlyArray<{ prefix: string; category: HttpRequestCategory }> = [
  { prefix: '/api/admin/monitoring', category: 'monitoring' },
  { prefix: '/api/admin', category: 'admin' },
  { prefix: '/api/auth', category: 'auth' },
  { prefix: '/api/profile', category: 'profile' },
  { prefix: '/api/profiles', category: 'profile' },
  { prefix: '/api/friends', category: 'friends' },
  { prefix: '/api/blocks', category: 'profile' },
  { prefix: '/api/support', category: 'support' },
  { prefix: '/api/chat', category: 'chat' },
  { prefix: '/api/topics', category: 'topics' },
  { prefix: '/api/players', category: 'players' },
  { prefix: '/api/leaderboards', category: 'leaderboards' },
  { prefix: '/api/shop', category: 'shop' },
  { prefix: '/api/vip', category: 'vip' },
  { prefix: '/api/tournaments', category: 'tournaments' },
  { prefix: '/api/missions', category: 'missions' },
  { prefix: '/api/daily-rewards', category: 'dailyRewards' },
  { prefix: '/api/contact/guest', category: 'guest' },
  { prefix: '/api/guest-trial-status', category: 'guest' },
  { prefix: '/uploads', category: 'uploads' },
  { prefix: '/api/public-settings', category: 'public' },
  { prefix: '/api/public', category: 'public' },
  { prefix: '/health', category: 'health' },
]

export function classifyHttpRequestPath(pathname: string): HttpRequestCategory {
  for (const rule of PREFIX_RULES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix + '/')) {
      return rule.category
    }
  }
  return 'other'
}
