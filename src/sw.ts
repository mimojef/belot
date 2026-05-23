/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { NetworkFirst, NetworkOnly } from 'workbox-strategies'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// API и uploads — само мрежа, без кеш
registerRoute(/^\/api\//, new NetworkOnly())
registerRoute(/^\/uploads\//, new NetworkOnly())

// Navigation requests: опитай мрежата (сървърът връща index.html за всички SPA routes).
// Ако мрежата се провали (реален offline) — сервирай offline.html от precache.
const navigationHandler = new NetworkFirst({
  cacheName: 'navigation-cache',
  plugins: [
    new CacheableResponsePlugin({ statuses: [200] }),
    {
      handlerDidError: async () => {
        return (await caches.match('/offline.html')) ?? Response.error()
      },
    },
  ],
})

registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/api\//, /^\/ws/, /^\/uploads\//, /^\/health/],
  }),
)
