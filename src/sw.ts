/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { NetworkOnly } from 'workbox-strategies'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// API and uploads must never be served from an old cache.
registerRoute(/^\/api\//, new NetworkOnly())
registerRoute(/^\/uploads\//, new NetworkOnly())

// Navigation requests always use the network so a stale app shell cannot outlive a deploy.
// If the network is truly unavailable, serve the precached offline page.
const navigationHandler = new NetworkOnly({
  plugins: [
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
