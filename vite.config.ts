import { execSync } from 'node:child_process'
import { defineConfig, type InlineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

function resolveBuildId(): string {
  if (process.env.VITE_BUILD_ID) {
    return process.env.VITE_BUILD_ID
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return `t${Date.now()}`
  }
}

function disableServiceWorkerCodeSplitting(options: InlineConfig): void {
  const output = options.build?.rollupOptions?.output
  if (!output) {
    return
  }

  const outputs = Array.isArray(output) ? output : [output]
  for (const swOutput of outputs) {
    if (!swOutput || typeof swOutput !== 'object') {
      continue
    }

    const mutableOutput = swOutput as Record<string, unknown>
    delete mutableOutput.inlineDynamicImports
    mutableOutput.codeSplitting = false
  }
}

// Свара (Етап 2А): всички chunks с модули от анимационния прототип или от
// pixi.js получават префикс "svara-", за да се изключат от PWA precache-а
// (виж globIgnores по-долу) — графичните зависимости се свалят само при
// отваряне на Свара, не от всеки посетител чрез service worker-а.
const SVARA_CHUNK_MODULE_PATTERN = /[\\/](?:src[\\/]app[\\/]games[\\/]svara[\\/]demo|node_modules[\\/](?:pixi\.js|@pixi))[\\/]/

function isSvaraChunk(moduleIds: readonly string[]): boolean {
  return moduleIds.some((id) => SVARA_CHUNK_MODULE_PATTERN.test(id))
}

// Гласов чат (Етап 3): voice runtime-ът (controller + LiveKit адаптер +
// livekit-client/@livekit/*) се зарежда САМО с dynamic import от voiceFacade
// -> chunks с префикс "voice-", изключени от PWA precache-а (globIgnores) —
// потребител, който не включва гласа, не ги изтегля нито при отваряне, нито
// през service worker-а. voiceFacade.ts е единственият гласов модул в
// основния bundle.
const VOICE_CHUNK_MODULE_PATTERN = /[\\/](?:node_modules[\\/](?:livekit-client|@livekit)[\\/]|src[\\/]app[\\/]voice[\\/](?!voiceFacade\.ts))/

function isVoiceChunk(moduleIds: readonly string[]): boolean {
  return moduleIds.some((id) => VOICE_CHUNK_MODULE_PATTERN.test(id))
}

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        // facadeModuleId покрива и фасадните re-export chunks на pixi.js
        // (WebGLRenderer/WebGPURenderer), които нямат собствени модули.
        chunkFileNames: (chunk) => {
          const moduleIds = [...chunk.moduleIds, chunk.facadeModuleId ?? '']
          if (isSvaraChunk(moduleIds)) return 'assets/svara-[name]-[hash].js'
          if (isVoiceChunk(moduleIds)) return 'assets/voice-[name]-[hash].js'
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
  define: {
    __PWA_BUILD_ID__: JSON.stringify(resolveBuildId()),
  },
  server: {
    proxy: {
      '/uploads': 'http://localhost:3001',
      // Снимките от профилната галерия идват само от удостоверения маршрут
      // (относителен /api/... URL в galleryImages[].imageUrl).
      '^/api/profiles/[^/]+/gallery/': 'http://localhost:3001',
    },
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'Pika.bg - Белот Онлайн',
        short_name: 'Пика',
        description: 'Играй белот онлайн с приятели',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0a0a',
        theme_color: '#d4a520',
        lang: 'bg',
        icons: [
          {
            src: '/icons/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,svg,png,webp,mp3,woff2}'],
        globIgnores: ['index.html', 'assets/svara-*', 'assets/voice-*'],
        injectionPoint: 'self.__WB_MANIFEST',
        // "Подари авоари" feature добавка бутна главния bundle леко над
        // default 2 MiB precache лимита (2095KB baseline -> 2100KB). Вдигнат
        // с margin (3 MiB), не премахнат — все още предпазва от неконтролируем
        // растеж занапред, само отразява текущия реален размер.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      integration: {
        configureCustomSWViteBuild: disableServiceWorkerCodeSplitting,
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
})
