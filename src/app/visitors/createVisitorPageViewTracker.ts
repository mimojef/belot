export type VisitorNavigationType = 'navigate' | 'reload' | 'back_forward' | 'spa'

export type VisitorViewLayout = 'mobile' | 'desktop'

type VisitorTrackerOptions = {
  endpointUrl: string
  getViewLayout: () => VisitorViewLayout
}

type VisitorUtmPayload = Partial<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_term' | 'utm_content', string>>

const STORAGE_KEY = 'pika_anonymous_visitor_id'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UTM_LIMITS = {
  utm_source: 64,
  utm_medium: 64,
  utm_campaign: 128,
  utm_term: 128,
  utm_content: 128,
} as const

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function getAnonymousVisitorId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY)
    if (existing !== null && UUID_RE.test(existing)) {
      return existing.toLowerCase()
    }

    const next = createUuid()
    localStorage.setItem(STORAGE_KEY, next)
    return next
  } catch {
    return createUuid()
  }
}

function getNavigationType(): VisitorNavigationType {
  const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  if (navEntry?.type === 'reload') return 'reload'
  if (navEntry?.type === 'back_forward') return 'back_forward'
  return 'navigate'
}

function getPagePath(): string {
  return window.location.pathname || '/'
}

function getPageUrlWithoutQuery(): string {
  return `${window.location.origin}${getPagePath()}`
}

function getUtmPayload(): VisitorUtmPayload {
  const params = new URLSearchParams(window.location.search)
  const utm: VisitorUtmPayload = {}

  for (const [key, maxLength] of Object.entries(UTM_LIMITS) as Array<[keyof typeof UTM_LIMITS, number]>) {
    const value = params.get(key)?.trim() ?? ''
    if (value.length > 0 && value.length <= maxLength) {
      utm[key] = value
    }
  }

  return utm
}

export function createVisitorPageViewTracker(options: VisitorTrackerOptions): { start: () => void } {
  let started = false
  let lastPageUrl = getPageUrlWithoutQuery()
  const anonymousVisitorId = getAnonymousVisitorId()

  function sendPageView(navigationType: VisitorNavigationType, referrer: string | null, viewLayout: VisitorViewLayout, isEntry: boolean): void {
    const body = {
      anonymousVisitorId,
      pageViewId: createUuid(),
      path: getPagePath(),
      navigationType,
      referrer,
      utm: getUtmPayload(),
      viewLayout,
      isEntry,
    }

    void fetch(options.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(() => {
      // Visitor tracking must never affect the app flow.
    })
  }

  function trackCurrentPage(navigationType: VisitorNavigationType, referrer: string | null, viewLayout: VisitorViewLayout, isEntry: boolean): void {
    sendPageView(navigationType, referrer, viewLayout, isEntry)
    lastPageUrl = getPageUrlWithoutQuery()
  }

  function patchPushState(viewLayout: VisitorViewLayout): void {
    const originalPushState = history.pushState.bind(history)
    history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
      const before = getPageUrlWithoutQuery()
      const result = originalPushState(data, unused, url)
      const after = getPageUrlWithoutQuery()
      if (after !== before) {
        trackCurrentPage('spa', before, viewLayout, false)
      }
      return result
    }) as History['pushState']
  }

  function start(): void {
    if (started) return
    started = true

    // viewLayout is captured once at startup and never changes on resize/rotation.
    const viewLayout = options.getViewLayout()

    patchPushState(viewLayout)
    // The initial page load is always an entry, regardless of navigation type.
    trackCurrentPage(getNavigationType(), document.referrer || null, viewLayout, true)

    window.addEventListener('popstate', () => {
      const previousPageUrl = lastPageUrl
      // In-app back/forward is not a new entry — the app is already running.
      trackCurrentPage('back_forward', previousPageUrl, viewLayout, false)
    })
  }

  return { start }
}
